#!/bin/sh
set -eu

: "${ACCESS_PASSWORD:?Set ACCESS_PASSWORD before starting the container}"
ACCESS_USERNAME=${ACCESS_USERNAME:-hajimimi}
case "$ACCESS_USERNAME" in
  ''|*[!a-zA-Z0-9_.-]*)
    printf '%s\n' 'ACCESS_USERNAME must contain only letters, digits, dots, underscores or hyphens.' >&2
    exit 1
    ;;
esac

# Read from stdin, not process arguments; only a bcrypt hash is written to disk.
umask 027
printf '%s\n' "$ACCESS_PASSWORD" | htpasswd -i -B -C 10 -c /etc/nginx/.htpasswd "$ACCESS_USERNAME"
chown root:nginx /etc/nginx/.htpasswd
chmod 640 /etc/nginx/.htpasswd
