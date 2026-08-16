/**
 * SENTIO Backend Server v2.1
 * Handles yt-dlp YouTube resolution and health checks
 * Includes yt-dlp installation via Dockerfile with full path fixes
 */

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory cache for pending resolutions
const pendingResolutions = new Map();

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'sentio-backend',
    timestamp: new Date().toISOString(),
    youtubeResolver: {
      available: false,
      provider: 'yt-dlp'
    }
  };

  try {
    const { stdout: versionOutput } = await execAsync('/usr/local/bin/yt-dlp --version');
    health.youtubeResolver.available = true;
    health.youtubeResolver.version = versionOutput.trim();
    console.log(`[Backend] yt-dlp version: ${versionOutput.trim()}`);
  } catch (error) {
    console.error('[Backend] yt-dlp not available:', error.message);
    health.youtubeResolver.error = 'yt-dlp not installed';
  }

  res.json(health);
});

// YouTube health check
app.get('/api/health/youtube', async (req, res) => {
  try {
    // Check yt-dlp version
    const { stdout: versionOutput } = await execAsync('/usr/local/bin/yt-dlp --version');
    const version = versionOutput.trim();
    
    // Check impersonation targets
    let impersonation = false;
    try {
      const { stdout: impersonateOutput } = await execAsync('/usr/local/bin/yt-dlp --list-impersonate-targets');
      impersonation = impersonateOutput.includes('available');
    } catch (err) {
      console.log('[Backend] Impersonation check failed (may not be supported):', err.message);
    }

    res.json({
      ytdlp: 'available',
      ytdlpVersion: version,
      impersonation: impersonation,
      youtubeCache: 'supabase' // Assuming Supabase cache
    });
  } catch (error) {
    console.error('[Backend] Health check failed:', error);
    res.status(503).json({
      ytdlp: 'unavailable',
      error: error.message
    });
  }
});

// YouTube resolution endpoint
app.post('/api/youtube/resolve', async (req, res) => {
  const { artist, title } = req.body;
  
  if (!artist || !title) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // Check if yt-dlp is available
  try {
    await execAsync('/usr/local/bin/yt-dlp --version');
  } catch (error) {
    console.error('[Backend] yt-dlp not available for resolution');
    return res.status(503).json({ 
      error: 'yt-dlp is not installed on the backend',
      code: 'YTDLP_NOT_INSTALLED'
    });
  }

  const cacheKey = `${artist}::${title}`;
  
  // Check if resolution is already in progress
  if (pendingResolutions.has(cacheKey)) {
    console.log(`[Backend] Resolution already in progress for: ${artist} - ${title}`);
    const existingPromise = pendingResolutions.get(cacheKey);
    try {
      const result = await existingPromise;
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // Start new resolution
  const resolutionPromise = (async () => {
    console.log(`[Backend] Starting yt-dlp resolution for: ${artist} - ${title}`);
    
    try {
      // Build yt-dlp search query (no outer quotes around the search query)
      const searchQuery = `ytsearch5:${artist} ${title}`;
      
      // Execute yt-dlp command
      const command = `/usr/local/bin/yt-dlp "${searchQuery}" --print "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s" --no-playlist --skip-download --quiet`;
      
      console.log(`[Backend] Executing: yt-dlp search for "${artist} ${title}"`);
      
      const { stdout } = await execAsync(command);
      
      if (!stdout || stdout.trim() === '') {
        throw new Error('No results found');
      }

      // Parse yt-dlp output
      const parts = stdout.trim().split('|');
      if (parts.length < 5) {
        throw new Error('Invalid yt-dlp output format');
      }

      const [videoId, videoTitle, uploader, duration, thumbnail] = parts;

      console.log(`[Backend] Successfully resolved: ${artist} - ${title} → ${videoId}`);

      return {
        videoId,
        title: videoTitle,
        artist,
        uploader,
        duration: parseInt(duration),
        thumbnail,
        resolvedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error(`[Backend] Resolution failed for ${artist} - ${title}:`, error.message);
      throw error;
    }
  })();

  pendingResolutions.set(cacheKey, resolutionPromise);

  try {
    const result = await resolutionPromise;
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Resolution failed' });
  } finally {
    pendingResolutions.delete(cacheKey);
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`[Backend] SENTIO server running on port ${PORT}`);
  console.log(`[Backend] Health check: http://localhost:${PORT}/api/health`);
  console.log(`[Backend] YouTube health: http://localhost:${PORT}/api/health/youtube`);
  
  // Startup diagnostics
  try {
    const { stdout: versionOutput } = await execAsync('/usr/local/bin/yt-dlp --version');
    console.log(`[Backend] yt-dlp version: ${versionOutput.trim()}`);
  } catch (error) {
    console.error('[Backend] WARNING: yt-dlp not available:', error.message);
  }
});