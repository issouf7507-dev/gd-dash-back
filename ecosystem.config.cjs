// Configuration PM2 de l'API en production (utilisée par le workflow de déploiement).
module.exports = {
  apps: [
    {
      name: 'gd-gest-api',
      cwd: __dirname,
      script: 'dist/index.js',
      // fork, pas cluster : le mode cluster plante au démarrage avec une API en ES modules + --env-file.
      exec_mode: 'fork',
      node_args: '--env-file=.env --enable-source-maps',
      max_memory_restart: '300M',
    },
  ],
}
