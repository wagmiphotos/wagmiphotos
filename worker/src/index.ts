export default {
  async fetch(request: Request, _env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    return new Response("Not found", { status: 404 });
  },
};
