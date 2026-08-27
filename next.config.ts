import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Vercel's WebSocket upgrader dynamically loads ws at runtime. Bundling ws
  // replaces its optional buffer implementation and breaks frame unmasking.
  serverExternalPackages: ["ws", "microsoft-cognitiveservices-speech-sdk", "unpdf"],
  webpack: (config) => {
    config.module.rules.unshift({
      enforce: "pre",
      test: /talkinghead[\\/]modules[\\/]talkinghead\.mjs$/,
      use: [{ loader: path.resolve(process.cwd(), "webpack/talkinghead-loader.cjs") }],
    });
    return config;
  },
};

export default nextConfig;
