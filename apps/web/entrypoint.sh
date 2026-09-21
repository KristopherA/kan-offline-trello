#!/bin/sh

# Run migrations from the Turborepo root context
echo "Running database migrations..."
# Navigate to the Turborepo root to run the db:migrate command
pnpm --prefix /app db:migrate

# Check if migration was successful
if [ $? -ne 0 ]; then
  echo "\nDatabase migration failed! Exiting."
  exit 1
fi

echo "\nStarting Next.js application..."

# Check if we should use standalone mode
if [ "$NEXT_PUBLIC_USE_STANDALONE_OUTPUT" = "true" ]; then
  echo "Starting in standalone mode..."
  exec node .next/standalone/apps/web/server.js
else
  echo "Starting in standard mode..."
  exec pnpm start
fi