// Font atlas generator for GPU text rendering

export class FontAtlasGenerator {
    constructor(fontFamily = 'Arial', fontSize = 24, fontWeight = 'normal') {
        this.fontFamily = fontFamily;
        this.fontSize = fontSize;
        this.fontWeight = fontWeight;
        this.padding = 2;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.glyphs = {};
        this.texture = null;
        this.device = null;
    }
    
    // Create and initialize the font atlas texture
    async initialize(device, chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,?!@#$%^&*()-=+/\\\'":;[]{}()<> ') {
        this.device = device;
        
        // Measure all characters first
        this.ctx.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
        
        let totalWidth = 0;
        let maxHeight = this.fontSize * 1.2;
        
        // Measure each glyph
        for (const char of chars) {
            const metrics = this.ctx.measureText(char);
            const width = Math.ceil(metrics.width) + this.padding * 2;
            
            this.glyphs[char] = {
                width,
                height: maxHeight,
                xOffset: totalWidth
            };
            
            totalWidth += width;
        }
        
        // Create atlas with power-of-two dimensions
        const atlasWidth = nextPowerOfTwo(totalWidth);
        const atlasHeight = nextPowerOfTwo(maxHeight);
        this.canvas.width = atlasWidth;
        this.canvas.height = atlasHeight;
        
        // Clear canvas to black
        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, atlasWidth, atlasHeight);
        
        // Draw white text
        this.ctx.fillStyle = 'white';
        this.ctx.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
        this.ctx.textBaseline = 'top';
        
        for (const char of chars) {
            const glyph = this.glyphs[char];
            const x = glyph.xOffset + this.padding;
            const y = this.padding;
            
            // Calculate normalized texture coordinates
            glyph.u = glyph.xOffset / atlasWidth;
            glyph.v = 0;
            glyph.uWidth = glyph.width / atlasWidth;
            glyph.vHeight = glyph.height / atlasHeight;
            
            this.ctx.fillText(char, x, y);
        }
        
        // Create WebGPU texture
        const imageData = this.ctx.getImageData(0, 0, atlasWidth, atlasHeight);
        const textureData = new Uint8Array(imageData.data);
        
        this.texture = device.createTexture({
            label: "Font Atlas",
            size: [atlasWidth, atlasHeight, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        
        device.queue.writeTexture(
            { texture: this.texture },
            textureData,
            { bytesPerRow: atlasWidth * 4, rowsPerImage: atlasHeight },
            [atlasWidth, atlasHeight, 1]
        );
        
        return this;
    }
    
    // Get a glyph from the atlas
    getGlyph(char) {
        return this.glyphs[char] || this.glyphs['?'];
    }
    
    // Calculate the width of a text string
    measureText(text) {
        let width = 0;
        for (const char of text) {
            const glyph = this.getGlyph(char);
            width += glyph.width - this.padding * 2; // Subtract padding
        }
        return width;
    }
    
    // Create a bindgroup for this font atlas
    createBindGroup(pipeline, bindGroupIndex = 1) {
        const sampler = this.device.createSampler({
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
        });
        
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(bindGroupIndex),
            entries: [
                { binding: 0, resource: this.texture.createView() },
                { binding: 1, resource: sampler }
            ]
        });
    }
}

// Utility function
function nextPowerOfTwo(value) {
    return Math.pow(2, Math.ceil(Math.log2(value)));
}
