const listeners = new Map();

export function addMatchListener(matchId, response) {
  const key = String(matchId);
  const bucket = listeners.get(key) || new Set();
  bucket.add(response);
  listeners.set(key, bucket);
  return () => {
    bucket.delete(response);
    if (!bucket.size) listeners.delete(key);
  };
}

export function publishMatchUpdate(matchId, payload) {
  const bucket = listeners.get(String(matchId));
  if (!bucket) return;
  const message = `event: match-update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of bucket) {
    try { response.write(message); } catch { bucket.delete(response); }
  }
}
