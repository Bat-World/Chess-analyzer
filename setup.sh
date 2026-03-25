#!/bin/bash
# Downloads required JS files for the extension

set -e
echo "Setting up Chess Analyzer extension..."

# 1. Download chess.js (move validation + PGN parsing)
echo "Downloading chess.js..."
curl -sL "https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.13.4/chess.min.js" -o chess.js
echo "  chess.js downloaded"

# 2. Download Stockfish WASM (single-threaded, works in offscreen document)
echo "Downloading Stockfish WASM..."
curl -sL "https://unpkg.com/stockfish@16.0.0/src/stockfish-nnue-16-single.js" -o stockfish.js
echo "  stockfish.js downloaded"

# 3. Placeholder icons (replace with real ones if desired)
echo "Creating placeholder icons..."
mkdir -p icons
for size in 16 48 128; do
  # Create a simple placeholder PNG using Python (no ImageMagick needed)
  python3 -c "
import struct, zlib

def create_png(size):
    def chunk(name, data):
        c = struct.pack('>I', len(data)) + name + data
        crc = zlib.crc32(c[4:]) & 0xffffffff
        return c + struct.pack('>I', crc)

    # Simple green square
    raw = b''
    for y in range(size):
        raw += b'\\x00'
        for x in range(size):
            raw += b'\\x1a\\x1a\\x2e'  # dark blue RGB

    compressed = zlib.compress(raw)

    png = b'\\x89PNG\\r\\n\\x1a\\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

with open('icons/icon${size}.png', 'wb') as f:
    f.write(create_png(${size}))
"
done
echo "  Icons created"

echo ""
echo "Setup complete! Now:"
echo "  1. Open Chrome -> chrome://extensions"
echo "  2. Enable 'Developer mode' (top right)"
echo "  3. Click 'Load unpacked' -> select this folder"
echo "  4. Click the extension icon -> enter your OpenAI API key"
echo "  5. Go to chess.com -> click '♟ Analyze' button"
