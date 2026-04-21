/**
 * Single shared PrismaClient instance for the entire application.
 * Multiple instances each create their own connection pool, which
 * exhausts PostgreSQL's max_connections under load.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default prisma;
