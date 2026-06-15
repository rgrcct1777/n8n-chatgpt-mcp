import express from 'express';

const router = express.Router();

router.get('/login', (_req, res) => {
  res.json({ message: 'OAuth login is not configured for local development.' });
});

router.get('/token-request', (_req, res) => {
  res.json({
    message: 'Authentication is disabled. Use the MCP endpoints directly.',
    endpoints: { health: '/health', mcp: 'POST /' },
  });
});

export default router;
