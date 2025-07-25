const { $ } = require("bun");

const [ output, image, video, html ] = process.argv.slice(2);

if (!output || !image || !video) {
  console.log("Usage: bun run beheader.js <output> <image> <video> [html] [pdf, zip, jar, apk, ...]");
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
  // Set ICO image count to 1 and clear ftyp atom name
  // It seems that, at least for ffmpeg, the name isn't actually required
  ftypBuffer.set([1, 0, 0, 0], 4);

  // Now the ftyp atom is ready, replace it and write the output file
  await Bun.write(atomFile, ftypBuffer);
  await $`./mp4edit --replace ftyp:"${tmp + ".atom"}" "${tmp + "2.mp4"}" "${output}"`;

  // Append any other files found on the command line
  const appendables = process.argv.slice(6);
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

