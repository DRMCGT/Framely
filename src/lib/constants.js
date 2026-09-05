// Video Background Studio - constants
// Centralized presets so UI and logic stay in sync.

export const RESOLUTION_PRESETS = {
  source: { label: 'Same as source', width: null, height: null },
  '1080p': { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  '1440p': { label: '1440p (2560×1440)', width: 2560, height: 1440 },
  '4k': { label: '4K (3840×2160)', width: 3840, height: 2160 }
};

export const QUALITY_PRESETS = {
  fast: { label: 'Fast', crf: 28, preset: 'veryfast', audioBitrate: '128k' },
  balanced: { label: 'Balanced', crf: 23, preset: 'medium', audioBitrate: '192k' },
  high: { label: 'High', crf: 18, preset: 'slow', audioBitrate: '256k' }
};

// Soft warn threshold — no hard block, tunable after real memory testing
export const SOFT_SIZE_WARN_BYTES = 200 * 1024 * 1024; // 200 MB
export const RECOMMENDED_MAX_DIM = 3840; // warn if source > 4K on longest side

export const DEFAULTS = {
  radius: 10,
  scale: 85, // percent of canvas width/height the inner video occupies
  shadow: true,
  shadowIntensity: 24, // px blur
  resolution: '1080p',
  quality: 'balanced'
};
