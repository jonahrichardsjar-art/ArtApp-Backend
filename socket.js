// backend/socket.js
// Holds the Socket.io server instance so any route file can import it
// without creating a circular dependency with index.js

import { Server } from 'socket.io';

let io = null;

export function initIO(httpServer) {
    io = new Server(httpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
    });
    return io;
}

export function getIO() {
    if (!io) throw new Error('Socket.io not initialized');
    return io;
}
