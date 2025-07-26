const { $ } = require("bun");
const fs = require("fs/promises");

// Parse command line by cloning argv and removing flags first
const argv = structuredClone(process.argv);

let extra = "";

// Search for supported flags, handle them, and remove them from argv clone
for (let i = argv.length - 1; i >= 0; i --) {
  let match = true;
  switch (argv[i]) {
    case "--extra": extra = await Bun.file(argv[i + 1]).text(); break;
    default: match = false; break;
  }
  if (match) argv.splice(i, 2);
}

// All remaining parameters are positional
const [ output, image, video, html, pdf ] = argv.slice(2);

if (!output || !image || !video) {
  console.log("Usage: bun run beheader.js <output> <image> <video> [html] [pdf] [zip|jar|apk|...]");
  process.exit(1);
}

// Converts a number to a 4-byte little-endian uint8 buffer
function numberTo4bLE (num) {
  const bytes = new Uint8Array(4);
  bytes[0] = num & 0xFF;
  bytes[1] = (num >> 8) & 0xFF;
  bytes[2] = (num >> 16) & 0xFF;
  bytes[3] = (num >> 24) & 0xFF;
  return bytes;
}

// Converts a number to a 4-byte big-endian uint8 buffer
function numberTo4bBE (num) {
  const bytes = new Uint8Array(4);
  bytes[3] = num & 0xFF;
  bytes[2] = (num >> 8) & 0xFF;
  bytes[1] = (num >> 16) & 0xFF;
  bytes[0] = (num >> 24) & 0xFF;
  return bytes;
}

// Finds the index of a sub-array in an array
function findSubArrayIndex (array, subArray) {
  for (let i = 0; i <= array.length - subArray.length; i++) {
    let match = true;
    for (let j = 0; j < subArray.length; j++) {
      if (array[i + j] !== subArray[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

const tmp = Math.random().toString(36).slice(2);

// Convert input image to 32 bpp PNG, strip all metadata
await $`convert "${image}" -define png:color-type=6 -depth 8 -alpha on -strip "${tmp + ".png"}"`;

const pngFile = Bun.file(tmp + ".png");
const atomFile = Bun.file(tmp + ".atom");
const htmlFile = html && Bun.file(html);
const pdfFile = pdf && Bun.file(pdf);

const ftypBuffer = new Uint8Array(256);
const encoder = new TextEncoder();

// Wrap in try/catch/finally to clean up temporary files on error
try {

  ftypBuffer[2] = 1; // ICO signature | 256 byte atom size

  // Write the MP4 "ftyp" atom name
  // This seems unnecessary, we do this just to not confuse mp4edit
  ftypBuffer.set(encoder.encode("ftyp"), 4);

  ftypBuffer[12] = 32; // First image bit depth
  ftypBuffer.set(numberTo4bLE(pngFile.size), 14); // Image data size

  // Re-encode input video to a highly normalized MP4
  await $`ffmpeg -i "${video}" -c:v libx264 -strict -2 -preset slow -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -f mp4 "${tmp + "0.mp4"}"`.quiet();

  // The ftyp atom is not yet finished, we replace it only to measure offsets
  await Bun.write(atomFile, ftypBuffer);
  await $`./mp4edit --replace ftyp:"${tmp + ".atom"}" "${tmp + "0.mp4"}" "${tmp + "1.mp4"}"`;

  // Wrap the input HTML document (if any) to avoid rendering surrounding garbage
  const htmlString = html ? `--><style>body{font-size:0}</style><div style=font-size:initial>${await htmlFile.text()}</div><!--` : "";

  // Create a buffer for the PNG file
  // If applicable, we'll append HTML to this same atom
  const pngFileBuffer = new Uint8Array(pngFile.size + htmlString.length);
  pngFileBuffer.set(await pngFile.bytes());
  if (html) pngFileBuffer.set(encoder.encode(htmlString), pngFile.size);

  // Create a "skip" atom to store the PNG data
  const skipBufferHead = new Uint8Array(8);
  skipBufferHead.set(numberTo4bBE(pngFileBuffer.length + 8), 0);
  skipBufferHead.set(encoder.encode("skip"), 4);

  const skipBuffer = new Uint8Array(pngFileBuffer.length + 8);
  skipBuffer.set(skipBufferHead, 0);
  skipBuffer.set(pngFileBuffer, 8);

  // Insert the skip atom into the output file to get its final offset
  await Bun.write(atomFile, skipBuffer);
  await $`./mp4edit --insert skip:"${tmp + ".atom"}" "${tmp + "1.mp4"}" "${tmp + "2.mp4"}"`;

  // Find offset of PNG data in MP4 file
  const offsetReference = await Bun.file(tmp + "2.mp4").bytes();
  const pngOffset = findSubArrayIndex(offsetReference, skipBufferHead) + 8;

  // Set PNG data offset for first ICO image
  ftypBuffer.set(numberTo4bLE(pngOffset), 18);
  // Set ICO image count to 1 and clear atom name
  // Luckily, many players just assume that ftyp is the first atom
  ftypBuffer.set([1, 0, 0, 0], 4);

  // Add list of supported brands to help convince stubborn decoders
  ftypBuffer.set(encoder.encode("__isomiso2avc1mp41"), 22);
  // Create an HTML comment to help with filtering out garbage
  ftypBuffer.set(encoder.encode("<!--"), 40);
  // Add any user-provided early header data
  ftypBuffer.set(encoder.encode(extra), 44);

  if (pdf) {
    const pdfBuffer = await pdfFile.bytes();
    const mp4Size = Bun.file(tmp + "2.mp4").size;
    // Copy PDF header from input file
    ftypBuffer.set(pdfBuffer.slice(0, 9), 44 + extra.length);
    /**
     * Create a PDF object spanning the whole rest of the MP4.
     *
     * Since we're replacing data in an existing fixed-size buffer,
     * and the Length property is provided in ASCII, the value of
     * the number itself might shift the length.
     *
     * This routine dynamically adjusts the object definition string
     * until the number matches the actual length of the file.
     */
    let objString;
    // Start by assuming that the string contains the full file size
    let offset = 30 + mp4Size.toString().length;
    // Each iteration, decrement the offset and update the object string.
    // This is repeated until offset == string.length, at which point we
    // know that we've subtracted the correct amount.
    do {
      offset --;
      objString = `\n1 0 obj\n<</Length ${mp4Size - 53 - extra.length - offset}>>\nstream\n`;
    } while (offset !== objString.length);
    // Write the string into the dead space of the ftyp atom
    ftypBuffer.set(encoder.encode(objString), 53 + extra.length);
  }

  // Now the ftyp atom is ready, replace it and write the output file
  await Bun.write(atomFile, ftypBuffer);
  await $`./mp4edit --replace ftyp:"${tmp + ".atom"}" "${tmp + "2.mp4"}" "${output}"`;

  if (pdf) {
    // Second PDF pass - close the object and add the real PDF file
    const objectTerminator = encoder.encode("\nendstream\nendobj\n");
    const pdfBuffer = new Uint8Array(pdfFile.size + objectTerminator.length);
    pdfBuffer.set(objectTerminator);
    pdfBuffer.set(await pdfFile.bytes(), objectTerminator.length);
    // Append this buffer to the output file
    await fs.appendFile(output, pdfBuffer);
  }

  // Append any other files found on the command line
  const appendables = argv.slice(7);
  for (const path of appendables) {
    if (!path) continue;
    await $`cat "${path}" >> "${output}"`.quiet();
  }

  // Fix ZIP offsets (if applicable) to improve compatibility
  await $`zip -A "${output}"`.quiet();

} catch (e) {

  // Just forward the error, we're not handling it
  console.error(e);

} finally {

  try {
    await pngFile.delete();
    await atomFile.delete();

    await Bun.file(tmp + "0.mp4").delete();
    await Bun.file(tmp + "1.mp4").delete();
    await Bun.file(tmp + "2.mp4").delete();
  } catch { /* Cleanup can fail silently */ }

}

