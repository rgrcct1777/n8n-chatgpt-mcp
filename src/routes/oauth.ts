import express from 'express';

const router = express.Router();

router.get('/authorize', (_req, res) => {
  res.status(501).json({ error: 'OAuth is not configured for local development.' });
});

router.post('/token', (_req, res) => {
  res.status(501).json({ error: 'OAuth is not configured for local development.' });
});

export default router;
