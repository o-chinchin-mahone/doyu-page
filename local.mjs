// ローカル確認用: Function URL 形式のイベントを作って handler を呼ぶ（メモリ保存）
import { createServer } from "node:http";
import { handler } from "./src/index.mjs";

const port = process.env.PORT || 3000;
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, `http://localhost:${port}`);
  const result = await handler({
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: req.headers,
    requestContext: { http: { method: req.method, path: url.pathname, sourceIp: req.socket.remoteAddress } },
    body: Buffer.concat(chunks).toString(),
    isBase64Encoded: false,
  });
  res.writeHead(result.statusCode, result.headers);
  res.end(result.body);
// ★ 127.0.0.1 に束縛する。ホスト未指定だと全インターフェイス（0.0.0.0）で待ち受け、
//   同じ LAN の他端末から手元の開発サーバーに届いてしまう
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
