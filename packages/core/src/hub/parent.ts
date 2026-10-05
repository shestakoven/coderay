// The hub writes the token as the first line and keeps the pipe open for the core's whole life,
// so the end of stdin means the hub is gone, even when it was killed with SIGKILL.
export function followParent(stdin: NodeJS.ReadableStream, onGone: () => void): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    let tokenRead = false;
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      if (tokenRead) return;
      text += chunk;
      const end = text.indexOf('\n');
      if (end === -1) return;
      tokenRead = true;
      resolve(text.slice(0, end).trim());
    });
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      resolve(text.trim());
      onGone();
    };
    stdin.once('end', leave);
    stdin.once('error', leave);
  });
}
