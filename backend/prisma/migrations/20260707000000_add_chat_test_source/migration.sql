-- Add CHAT_TEST to the RunSource enum (synthetic chat-driven scenario test runs)
ALTER TYPE "RunSource" ADD VALUE IF NOT EXISTS 'CHAT_TEST';
