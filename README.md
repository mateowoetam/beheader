# beheader
Polyglot generator for media files.

### Dependencies
This project requires the [Bun JavaScript runtime](https://bun.sh/), and is built for Linux systems. You'll need `ffmpeg`, `imagemagick`, and `zip` in your `PATH`, as well as an executable [mp4edit](https://www.bento4.com/) binary in your working directory.

### Usage
With all dependencies set up, you should be able to run:
```
$ bun run beheader.js <output> <image> <video> [html] [pdf, zip, jar, apk, ...]
```
- `output` is the name of the output polyglot file.
- `image` is a path to the image to include. Note that regardless of what you provide, it will be converted to a PNG using ImageMagick.
- `video` is a path to the video file to include. This will be transcoded to MP4 using FFmpeg.
- `html` is an *optional* path to an HTML document. The code will be wrapped to prevent rendering garbage.

Further files will simply be appended to the output. Most notably, this works well for ZIP-like archives, PDF files, and some scripts. For ZIP archives, offsets will be adjusted to improve compatibility. **ZIP-like files should be included last**, to prevent the offset adjustment from breaking other appendables.

To avoid including an optional file, omit the argument or use an empty string (`""`) in its place.

The output file will be a polyglot of all of its inputs. On most systems, it will change behavior depending on its file extension:
- `.ico` displays the input image;
- `.mp4` plays the input video;
- `.html` shows the input webpage;
- `.pdf` opens the input PDF (if applicable).
- `.zip` extracts the input archive (if applicable);

Because of the several unholy beheadings that this script performs, some less tolerant (or less compliant) programs may fail early with errors about bad metadata or file type.
