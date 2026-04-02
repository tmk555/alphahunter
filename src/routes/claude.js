// ─── /api/claude route ──────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

module.exports = function(anthropic) {
  router.post('/claude', async (req, res) => {
    if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
    try {
      const { prompt, systemPrompt, useWebSearch = false, maxTokens = 1200 } = req.body;
      const tools = useWebSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : undefined;
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        ...(tools && { tools }), ...(systemPrompt && { system: systemPrompt }),
        messages: [{ role: 'user', content: prompt }],
      });
      res.json({ content: response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n') });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
