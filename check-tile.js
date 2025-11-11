import fs from 'fs';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

// Check both tiles
const tiles = [
    { name: '14/4935/6132', path: 'tile_14_4935_6132.pbf' },
    { name: '14/4936/6132', path: 'tile_14_4936_6132.pbf' }
];

tiles.forEach(tileInfo => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Tile: ${tileInfo.name}`);
    console.log('='.repeat(60));
    
    const buffer = fs.readFileSync(tileInfo.path);
    const pbf = new Pbf(buffer);
    const tile = new VectorTile(pbf);

    console.log('Layers:', Object.keys(tile.layers).join(', '));

    // Check water features
    if (tile.layers.water) {
        const layer = tile.layers.water;
        console.log(`\nWater: ${layer.length} features`);
        
        for (let i = 0; i < Math.min(10, layer.length); i++) {
            const feature = layer.feature(i);
            const geometry = feature.loadGeometry();
            
            let totalVertices = 0;
            geometry.forEach(ring => {
                totalVertices += ring.length;
            });
            
            console.log(`  Feature ${i}: ${totalVertices} vertices (${geometry.length} rings)`);
            console.log(`    Properties:`, feature.properties);
            if (geometry[0] && geometry[0].length <= 20) {
                console.log(`    Ring 0: ${geometry[0].map(p => `(${p.x},${p.y})`).join(', ')}`);
            }
        }
    }
});
