module.exports = {
  apps: [{
    name: "casino",
    script: "./node_modules/.bin/tsx",
    args: "src/index.ts",
    cwd: "/home/dev/casino",
    env: {
      PORT: "3000",
      WALLET_SERVICE_URL: "http://localhost:3002",
      WALLET_SERVICE_KEY: "svc_pf_f079a8443884c4713d7b99f033c8856ec73d980ab6157c3c",
      TREASURY_PRIVATE_KEY: "0x9439fa584368eec52e84a62a77f019c0abf4e10ea9ca37e49e3f53a9e8a1d333",
      WAGYU_API_KEY: "wg_451cbe528edd9019adb10fed794d45fde80f6bf5c9d0a2a11f2077a0",
    }
  }]
};
