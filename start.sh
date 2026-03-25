#!/bin/bash
node backend/dist/app.js &
cd frontend && npx vite preview --host 0.0.0.0 --port 5000
