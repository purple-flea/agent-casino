module.exports = {
  apps: [
    {
      name: "casino",
      script: "dist/index.js",
      cwd: "/home/dev/casino",
      env: {
        PORT: "3000",
        WALLET_SERVICE_URL: "http://localhost:3002",
        WALLET_SERVICE_KEY: "svc_pf_f079a8443884c4713d7b99f033c8856ec73d980ab6157c3c",
        TREASURY_PRIVATE_KEY: process.env.TREASURY_PRIVATE_KEY,
        WAGYU_API_KEY: "wg_451cbe528edd9019adb10fed794d45fde80f6bf5c9d0a2a11f2077a0",
      }
    },
    {
      name: "casino-xmr",
      script: "dist/xmr-monitor.js",
      cwd: "/home/dev/casino",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        TREASURY_PRIVATE_KEY: process.env.TREASURY_PRIVATE_KEY,
        PUBLIC_WALLET_URL: "http://localhost:3005",
        CASINO_XMR_API_KEY: process.env.CASINO_XMR_API_KEY || "",
      }
    }
  ]
};
