const worker = {
  async fetch(request, environment) {
    const url = new URL(request.url);

    if (url.pathname === "/shadow-cones") {
      url.pathname = "/shadow-cones/";
      return Response.redirect(url, 308);
    }

    if (url.pathname.endsWith("/")) {
      url.pathname += "index.html";
    }

    const response = await environment.ASSETS.fetch(
      new Request(url, request),
    );
    if (response.status !== 404) return response;

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

export default worker;
