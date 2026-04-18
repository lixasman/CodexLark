export function segmentText(input: { taskId: string; text: string; maxChars: number }): string[] {
  const { taskId, text, maxChars } = input;
  if (maxChars <= 0) throw new Error('maxChars must be greater than zero.');
  if (text.length <= maxChars) return [`${taskId} [1/1]\n${text}`];

  const bodyChunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    bodyChunks.push(text.slice(index, index + maxChars));
  }
  const total = bodyChunks.length;
  return bodyChunks.map((chunk, index) => `${taskId} [${index + 1}/${total}]\n${chunk}`);
}

