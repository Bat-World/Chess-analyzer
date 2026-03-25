// background.js — minimal, only proxies GPT calls (avoids CORS in some configs)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GPT_EXPLAIN') {
    callGPT(msg.prompt, msg.apiKey).then(sendResponse);
    return true;
  }
});

async function callGPT(prompt, apiKey) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content?.trim() ?? null };
  } catch (e) {
    return { error: e.message };
  }
}
