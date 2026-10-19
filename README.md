# AiVoid

Remove AI tags and other metadata from images, right in your browser.

Live at **[aivoid.shinelabsinnovations.com](https://aivoid.shinelabsinnovations.com)**

![AiVoid: strip the AI tags from your images](public/assets/og.jpg)

Drop in one image, a batch or a whole folder. AiVoid lists every metadata block it finds in each file, from Content Credentials and generation prompts to GPS coordinates and camera serial numbers. Everything starts out selected for removal, and you untick anything you want to keep. Cleaned files are saved as `name_stripped.ext`, and a batch downloads as one ZIP with your folder structure intact.

Your images never leave your device. Reading and cleaning both happen in the browser.

## What it removes

### AI provenance and generation data

- C2PA Content Credentials from Adobe Firefly, ChatGPT/DALL·E, Google, Microsoft and other signers, including the claimed generator and any AI-generated or AI-edited declaration
- Prompts and generation settings from AUTOMATIC1111 and Forge (`parameters`), ComfyUI (`prompt`, `workflow`), NovelAI, InvokeAI and Fooocus, plus prompts stored in the Exif UserComment field
- The IPTC digital source type (`trainedAlgorithmicMedia`, `compositeWithTrainedAlgorithmicMedia`) and the IPTC fields for the AI system and prompt
- Generator names in Software, CreatorTool, edit history, comments and captions: Midjourney, Stable Diffusion, FLUX, Firefly, Gemini, Imagen, Ideogram, Leonardo and others

### Personal and device data

- GPS location
- Camera and lens make, model and serial numbers
- Capture settings, dates and times
- Author, copyright, owner name, and the unique image and document IDs that can link copies of a file
- Maker notes, and embedded thumbnails that can still show the picture as it was before editing

### Everything else

XMP and extended XMP packets, IPTC/Photoshop resources, ICC colour profiles, comments, private chunks, extra embedded images and data appended after the end of the image.

Each item can be kept or removed per image, or for the whole batch at once.

## How it works

AiVoid edits the file's bytes directly. The picture is never decoded or re-encoded, so quality stays exactly as it was and the file only gets smaller by the size of the metadata.

| Format | What it handles |
|---|---|
| JPEG | Exif (by category), XMP and extended XMP, C2PA/JUMBF (APP11), ICC, IPTC/Photoshop (APP13), comments, other APPn blocks, MPF extra images and trailing data |
| PNG / APNG | text chunks, XMP, eXIf, iCCP, `caBX` C2PA, tIME, private chunks |
| WebP | EXIF, XMP, ICCP, C2PA and unknown chunks, with the VP8X flags and RIFF size rewritten |
| GIF | comments, XMP, ICC and other application blocks (the animation loop block stays) |
| HEIC / AVIF | Exif, XMP and C2PA are overwritten in place so item offsets stay valid |
| BMP | passed through unchanged |

Exif is rebuilt tag by tag, so you can keep the date and drop the location, for example. The orientation tag always stays so photos don't turn sideways. After cleaning, AiVoid parses each output file again to confirm that what you removed is gone.

## Run it locally

You need PHP 8.1 or later with the `pdo_sqlite` extension. There's no build step and nothing to install.

```bash
php -S localhost:5173 -t public tests/router.php
```

Then open http://localhost:5173. The router serves the site, the tests and the counting API, and keeps local counts in `.dev-data/`. To preview the metrics page with sample traffic, run `php tests/seed.php` first; the page labels that data as sample data, and `php tests/seed.php --clear` removes it.

You can also open `public/index.html` straight from disk to clean images. Counting is switched off in that case.

## Self-hosting

`public/` is the whole site. Serve it as the web root of any server that runs PHP 8.1 or later with `pdo_sqlite`.

- Only `api/hit.php` and `api/stats.php` need to run. Configure your web server so that no other `.php` file is served or executed.
- The API keeps its SQLite database, a random salt it generates on first use, and the optional country database in a folder named `aivoid-private` next to the web root (one level above `public/`). The web server user needs write access to it. Set the `AIVOID_DATA` environment variable to use another folder.
- For country stats, run `tools/update-geoip.sh <data folder>` once and then monthly from cron. Without it, visits are counted under "Unknown".
- The pages already carry a strict Content Security Policy in a meta tag. Sending it as a header too lets you add `frame-ancestors 'none'`.

## Metrics and privacy

The public [/metrics](https://aivoid.shinelabsinnovations.com/metrics) page shows visitors, files cleaned, downloads, page views and a country breakdown for today, yesterday, the last 7, 30 and 365 days, and all time.

- The browser sends one `visit` per page load and one `clean` per download, carrying only the number of files. File names, contents and metadata are never sent.
- Visitors are counted once per UTC day using `sha256(salt | day | IP | user agent)`. The IP address is only used to work out that hash and the visitor's country, and is never stored. Hashes are deleted after a day, so nobody can be followed from one day to the next. Someone who visits on two days therefore counts twice.
- Countries come from the free DB-IP country database, which the server updates once a month.
- Nothing is sent when Do Not Track or Global Privacy Control is on, or when the page is opened from disk. Common bots are ignored.
- The counting endpoint only accepts requests from the site's own origin, and the live site rate limits it. It's still a public endpoint, so someone determined to inflate the numbers could.

## Project layout

```
public/              the website (the web root)
  index.html         cleaner
  metrics.html       usage metrics
  api/               counting API (hit.php, stats.php, lib.php)
  js/core/           metadata engine
  js/app.js          cleaner interface
  js/hero.js         landing animation
  js/metrics.js      metrics interface
  js/track.js        anonymous counts
tools/               country database updater
tests/               engine tests, dev router, sample data, share card generator
```

## Tests

With the dev server running, open http://localhost:5173/tests/. The suite builds real JPEG, PNG, WebP and GIF files on a canvas, plus a synthetic HEIC, injects metadata into them, strips it again and checks that every output still decodes and reads back clean.

`tests/make-assets.html` redraws the share card and app icons into `public/assets/` while the dev server is running.

## A note on SynthID

AiVoid removes metadata, the information stored alongside the image. Google's SynthID is a different kind of mark.

SynthID is an invisible watermark from Google DeepMind. Google's models, such as Imagen and Gemini, embed it in the pixel values when they generate an image. It isn't stored in any metadata block, so it survives metadata removal, and it's designed to stay detectable after cropping, resizing, compression and colour changes. Google's SynthID Detector and the Gemini app can check whether an image carries it.

AiVoid leaves SynthID in place. The project only removes metadata and doesn't alter images to defeat provenance marks. The app says this plainly so nobody mistakes a cleaned file for an unmarked one.

## Credits

Designed and developed by [Shine Labs Innovations](https://www.shinelabsinnovations.com).

Country lookup uses [IP Geolocation by DB-IP](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## License

Copyright (C) 2026 Shine Labs Innovations.

AiVoid is released under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a public web service, the AGPL requires you to offer its source code to the people who use it.
