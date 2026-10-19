#!/bin/sh
# Page-ready derivatives of the capture masters: webp for every shot, the social card.
set -e
cd "$(dirname "$0")/assets"
for f in shots/*.png; do
  cwebp -quiet -q 88 -m 6 "$f" -o "${f%.png}.webp"
done
magick shots/plan.png -resize 1200x -gravity North -crop 1200x630+0+0 +repage og.png
