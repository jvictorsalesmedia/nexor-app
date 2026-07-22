import { rewrite } from "@vercel/functions";

export default function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/cliente/")) {
    return rewrite(new URL("/index.html", request.url));
  }
}

export const config = {
  matcher: ["/cliente/:path*"]
};
