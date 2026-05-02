#!/bin/bash
set -e
cd backend && npm install && npx prisma generate && npx prisma db push --accept-data-loss && npm run build && npm run db:seed
cd ../frontend && npm install && npm run build
