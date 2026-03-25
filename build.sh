#!/bin/bash
set -e
cd backend && npm install && npx prisma generate && npm run build
cd ../frontend && npm install && npm run build
