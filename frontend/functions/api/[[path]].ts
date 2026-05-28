// Cloudflare Pages Functions - 代理 /api/* 到 Worker
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api', '/api'); // 保持 /api/xxx 不变
  
  // Worker URL
  const workerUrl = `https://delicate-firefly-23d6.2824387178.workers.dev${path}${url.search}`;
  
  // 复制请求头（排除一些不需要的）
  const headers = new Headers(request.headers);
  headers.delete('host');
  
  // 转发请求到 Worker
  const workerResponse = await fetch(workerUrl, {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : undefined,
  });
  
  // 返回 Worker 的响应
  return new Response(workerResponse.body, {
    status: workerResponse.status,
    statusText: workerResponse.statusText,
    headers: workerResponse.headers,
  });
}