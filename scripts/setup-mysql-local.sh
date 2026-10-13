#!/usr/bin/env bash
# Prépare le MySQL local pour GD (à lancer une seule fois, ou pour réinitialiser le mot de passe de l'utilisateur gd).
# Crée les bases gd, gd_test et gd_shadow, et l'utilisateur défini dans .env (DATABASE_URL),
# avec des droits limités à ces trois bases.
# Le mot de passe d'administration MySQL (root) est demandé par le client mysql lui-même : il n'est ni affiché ni enregistré.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo ".env introuvable : copiez .env.example en .env"; exit 1; }
command -v mysql >/dev/null || { echo "Client mysql introuvable (brew install mysql)"; exit 1; }

# Lecture de DATABASE_URL (sans l'afficher)
read -r DB_USER DB_PASS DB_HOST DB_PORT < <(node -e '
  process.loadEnvFile(".env")
  const u = new URL(process.env.DATABASE_URL)
  console.log(decodeURIComponent(u.username), decodeURIComponent(u.password), u.hostname, u.port || 3306)
')
[[ "$DB_PASS" != "CHANGER_MOI" ]] || { echo "Remplacez CHANGER_MOI dans .env par un vrai mot de passe"; exit 1; }

read -r -p "Utilisateur administrateur MySQL [root] : " ADMIN
ADMIN=${ADMIN:-root}

echo "Création des bases et de l'utilisateur '$DB_USER' (mot de passe demandé pour '$ADMIN')…"
mysql -u "$ADMIN" -p -h "$DB_HOST" -P "$DB_PORT" <<SQL
CREATE DATABASE IF NOT EXISTS gd        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS gd_test   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS gd_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
CREATE USER IF NOT EXISTS '$DB_USER'@'::1'       IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'::1'       IDENTIFIED BY '$DB_PASS';

GRANT ALL PRIVILEGES ON gd.*        TO '$DB_USER'@'localhost', '$DB_USER'@'127.0.0.1', '$DB_USER'@'::1';
GRANT ALL PRIVILEGES ON gd_test.*   TO '$DB_USER'@'localhost', '$DB_USER'@'127.0.0.1', '$DB_USER'@'::1';
GRANT ALL PRIVILEGES ON gd_shadow.* TO '$DB_USER'@'localhost', '$DB_USER'@'127.0.0.1', '$DB_USER'@'::1';
FLUSH PRIVILEGES;
SQL

echo "✔ Bases gd, gd_test, gd_shadow et utilisateur '$DB_USER' prêts."
