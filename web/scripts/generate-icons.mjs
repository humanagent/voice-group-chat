import sharp from "sharp"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("../public/icons/room.svg", import.meta.url))
for (const [name, size] of [["room-192", 192], ["room-512", 512], ["room-maskable", 512], ["apple-touch-icon", 180]]) {
  await sharp(source).resize(size, size).png().toFile(fileURLToPath(new URL(`../public/icons/${name}.png`, import.meta.url)))
}
