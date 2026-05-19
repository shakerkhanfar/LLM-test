#!/bin/bash
set -e
cd backend && npx prisma db push --accept-data-loss
cd ..
node backend/dist/app.js
