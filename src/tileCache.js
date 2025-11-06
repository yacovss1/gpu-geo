export class TileCache {
    constructor(maxSize = 100) {
        this.cache = new Map(); // Store tiles in a Map
        this.maxSize = maxSize; // Maximum number of tiles to cache
    }

    // Retrieve a tile from the cache
    get(key) {
        if (this.cache.has(key)) {
            const tile = this.cache.get(key);
            // Move the tile to the end to mark it as recently used
            this.cache.delete(key);
            this.cache.set(key, tile);
            return tile;
        }
        return null;
    }

    // Store a tile in the cache
    set(key, tile) {
        if (this.cache.size >= this.maxSize) {
            // Remove the least recently used (LRU) tile
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, tile);
    }

    // Clear the cache
    clear() {
        this.cache.clear();
    }

    // Get cache statistics
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize
        };
    }
}
