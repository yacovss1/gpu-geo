export function roundTo6Places(value) {
    return Math.round(value * 1e6) / 1e6;
}

export function mercatorToClipSpace(coord) {
    const [lon, lat] = coord;
    const x = lon / 180;
    // Flip the Y coordinate by negating it
    const y = -Math.log(Math.tan(Math.PI/4 + (Math.PI/180)*lat/2)) / Math.PI;
    const scale = 1.0;
    return [roundTo6Places(x * scale), roundTo6Places(y * scale)];
}

export function hexToRgb(hex) {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return [r / 255, g / 255, b / 255];
}

const highlightedCountries = new Set();
const colorCache = new Map();

export function toggleCountryHighlight(countryCode) {
    if (highlightedCountries.has(countryCode)) {
        highlightedCountries.delete(countryCode);
    } else {
        highlightedCountries.add(countryCode);
    }
}

export function isCountryHighlighted(countryCode) {
    return highlightedCountries.has(countryCode);
}

export function getColorOfCountries(prop, defaultcolor) {
    if (!prop) return defaultcolor;
    
    // Immediate highlight check
    if (isCountryHighlighted(prop)) {
        return [1.0, 1.0, 0.0, 1.0];
    }
    
    if (colorCache.has(prop)) return colorCache.get(prop);
    
    const fillColors = [
        [
            [
                "ARM", "ATG", "AUS", "BTN", "CAN", "COG", "CZE", "GHA", "GIN", "HTI", 
                "ISL", "JOR", "KHM", "KOR", "LVA", "MLT", "MNE", "MOZ", "PER", "SAH", 
                "SGP", "SLV", "SOM", "TJK", "TUV", "UKR", "WSM"
            ],
            ["#D6C7FF"]
        ],
        [
            [
                "AZE", "BGD", "CHL", "CMR", "CSI", "DEU", "DJI", "GUY", "HUN", "IOA", 
                "JAM", "LBN", "LBY", "LSO", "MDG", "MKD", "MNG", "MRT", "NIU", "NZL", 
                "PCN", "PYF", "SAU", "SHN", "STP", "TTO", "UGA", "UZB", "ZMB"
            ],
            ["#EBCA8A"]
        ],
        [
            [
                "AGO", "ASM", "ATF", "BDI", "BFA", "BGR", "BLZ", "BRA", "CHN", "CRI", 
                "ESP", "HKG", "HRV", "IDN", "IRN", "ISR", "KNA", "LBR", "LCA", "MAC", 
                "MUS", "NOR", "PLW", "POL", "PRI", "SDN", "TUN", "UMI", "USA", "USG", 
                "VIR", "VUT"
            ],
            ["#C1E599"]
        ],
        [
            [
                "ARE", "ARG", "BHS", "CIV", "CLP", "DMA", "ETH", "GAB", "GRD", "HMD", 
                "IND", "IOT", "IRL", "IRQ", "ITA", "KOS", "LUX", "MEX", "NAM", "NER", 
                "PHL", "PRT", "RUS", "SEN", "SUR", "TZA", "VAT"
            ],
            ["#E7E58F"]
        ],
        [
            [
                "AUT", "BEL", "BHR", "BMU", "BRB", "CYN", "DZA", "EST", "FLK", "GMB", 
                "GUM", "HND", "JEY", "KGY", "LIE", "MAF", "MDA", "NGA", "NRU", "SLB", 
                "SOL", "SRB", "SWZ", "THA", "TUR", "VEN", "VGB"
            ],
            ["#98DDA1"]
        ],
        [
            [
                "AIA", "BIH", "BLM", "BRN", "CAF", "CHE", "COM", "CPV", "CUB", "ECU", 
                "ESB", "FSM", "GAZ", "GBR", "GEO", "KEN", "LTU", "MAR", "MCO", "MDV", 
                "NFK", "NPL", "PNG", "PRY", "QAT", "SLE", "SPM", "SYC", "TCA", "TKM", 
                "TLS", "VNM", "WEB", "WSB", "YEM", "ZWE"
            ],
            ["#83D5F4"]
        ],
        [
            [
                "ABW", "ALB", "AND", "ATC", "BOL", "COD", "CUW", "CYM", "CYP", "EGY", 
                "FJI", "GGY", "IMN", "KAB", "KAZ", "KWT", "LAO", "MLI", "MNP", "MSR", 
                "MYS", "NIC", "NLD", "PAK", "PAN", "PRK", "ROU", "SGS", "SVN", "SWE", 
                "TGO", "TWN", "VCT", "ZAF"
            ],
            ["#B1BBF9"]
        ]
    ];
    let color = [1, 1, 1, 1];
    fillColors.forEach(_fill => {
        _fill[0].forEach(_val => {
            if (_val === prop) {
                color = [...hexToRgb(_fill[1][0]), 1];
            }
        });
    });
    
    colorCache.set(prop, color);
    return color;
}

// Simple polygon area calculation
function calculatePolygonArea(coordinates) {
    let area = 0;
    const n = coordinates.length;
    
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += coordinates[i][0] * coordinates[j][1];
        area -= coordinates[j][0] * coordinates[i][1];
    }
    
    return Math.abs(area / 2);
}

export function clipSpaceToTile(x, y, zoom) {
    const scale = 1 << zoom; // 2^zoom
    const lon = x * 180; // Convert clip space to longitude
    const lat = (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) * (180 / Math.PI); // Convert clip space to latitude
    const tileX = Math.floor((lon + 180) / 360 * scale);
    const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * scale);
    return [tileX, tileY];
}

export function tileToClipSpace(tileX, tileY, zoom) {
    const scale = 1 << zoom; // 2^zoom
    const lon = (tileX / scale) * 360 - 180; // Convert tile X to longitude
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / scale))) * (180 / Math.PI); // Convert tile Y to latitude
    const x = lon / 180; // Convert longitude to clip space
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2; // Convert latitude to clip space
    return [x, y];
}

// Web Mercator tile coordinate conversion utilities
export function longitudeToTileX(lon, zoom) {
    const scale = 1 << zoom;
    return Math.floor((lon + 180) / 360 * scale);
}

export function latitudeToTileY(lat, zoom) {
    const scale = 1 << zoom;
    const latRad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale);
}

export function tileXToLongitude(x, zoom) {
    const scale = 1 << zoom;
    return (x / scale) * 360 - 180;
}

export function tileYToLatitude(y, zoom) {
    const scale = 1 << zoom;
    const n = Math.PI * (1 - 2 * y / scale);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// Convert clip space coordinates to lat/lon
export function clipSpaceToLatLon(x, y) {
    // Clip space to Longitude (x: -1 to 1 → lon: -180 to 180)
    const lon = x * 180;
    
    // Clip space to Latitude (inverse of the Web Mercator projection)
    // This approximation works for most use cases
    const latRad = 2 * Math.atan(Math.exp(Math.PI * y)) - Math.PI/2;
    const lat = latRad * 180 / Math.PI;
    
    return [lon, lat];
}