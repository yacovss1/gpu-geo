/**
 * PerformanceManager - Handles tile parsing performance tracking and monitoring
 * 
 * Note: GPU coordinate transformation has been removed (6-14x slower than CPU).
 * All coordinates are now transformed directly on CPU during tile parsing.
 * 
 * Responsibilities:
 * - Track tile parsing statistics
 * - Provide live performance monitoring
 * - Calculate throughput metrics
 */

export class PerformanceManager {
    constructor() {
        this.stats = {
            totalTilesParsed: 0,
            totalCoordinatesProcessed: 0,
            totalParseTime: 0,
            averageParseTime: 0,
            coordinatesPerSecond: 0
        };
        
        this.monitorInterval = null;
    }
    
    /**
     * Record a tile parse operation
     */
    recordParse(coordinateCount, timeMs) {
        this.stats.totalTilesParsed++;
        this.stats.totalCoordinatesProcessed += coordinateCount;
        this.stats.totalParseTime += timeMs;
        this.stats.averageParseTime = this.stats.totalParseTime / this.stats.totalTilesParsed;
        
        if (this.stats.totalParseTime > 0) {
            this.stats.coordinatesPerSecond = (this.stats.totalCoordinatesProcessed / this.stats.totalParseTime) * 1000;
        }
    }
    
    /**
     * Get current statistics
     */
    getStats() {
        return { ...this.stats };
    }
    
    /**
     * Reset all statistics
     */
    resetStats() {
        Object.keys(this.stats).forEach(key => {
            this.stats[key] = 0;
        });
    }
    
    /**
     * Log formatted performance statistics
     */
    logStats() {
        const stats = this.stats;
        
        if (stats.totalTilesParsed > 0) {
            console.log(`� Tile Parsing Performance:`);
            console.log(`  Total tiles parsed: ${stats.totalTilesParsed.toLocaleString()}`);
            console.log(`  Total coordinates: ${stats.totalCoordinatesProcessed.toLocaleString()}`);
            console.log(`  Total parse time: ${stats.totalParseTime.toFixed(2)}ms`);
            console.log(`  Average parse time: ${stats.averageParseTime.toFixed(2)}ms per tile`);
            console.log(`  Coordinates/second: ${stats.coordinatesPerSecond.toFixed(0)}`);
        } else {
            console.log(`📊 No tiles parsed yet`);
        }
    }
    
    /**
     * Enable live performance monitoring
     */
    enableLiveMonitoring(intervalMs = 5000) {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        
        this.monitorInterval = setInterval(() => {
            const stats = this.getStats();
            if (stats.totalTilesParsed > 0) {
                console.log(`📈 Live Stats: ${stats.totalTilesParsed} tiles, ` +
                          `${stats.totalCoordinatesProcessed.toLocaleString()} coords, ` +
                          `${stats.averageParseTime.toFixed(2)}ms avg`);
            }
        }, intervalMs);
    }
    
    /**
     * Disable live monitoring
     */
    disableLiveMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }
}

