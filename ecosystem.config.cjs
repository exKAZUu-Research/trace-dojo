module.exports = {
  apps: [
    {
      script: `NODE_ENV=production node_modules/.bin/dotenv -c ${process.env.WB_ENV} -- node node_modules/.bin/next start -p \${PORT:-8080}`,
    },
  ],
};
