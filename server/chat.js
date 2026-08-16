const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { Server } = require('socket.io');
const db = require('./db');
const { notify } = require('./notify');

// Returns { userId } if the token is valid, else null.
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.get('users').find({ id: payload.uid }).value();
    return user || null;
  } catch (e) {
    return null;
  }
}

// A user may join a booking's chat room only if they are the customer on
// that booking, or the professional assigned to it.
function canAccessBooking(user, booking) {
  if (!booking) return false;
  if (booking.userId === user.id) return true;
  const pro = db.get('professionals').find({ userId: user.id }).value();
  return !!(pro && booking.professionalId === pro.id);
}

function attachChat(httpServer, corsOptions) {
  const io = new Server(httpServer, {
    cors: corsOptions || { origin: true }
  });

  io.on('connection', (socket) => {
    const user = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) {
      socket.emit('chat_error', { error: 'Not authenticated.' });
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
    socket.data.lastMessageAt = 0;

    socket.on('join_booking', (bookingId) => {
      const booking = db.get('bookings').find({ id: bookingId }).value();
      if (!canAccessBooking(user, booking)) {
        socket.emit('chat_error', { error: 'You do not have access to this chat.' });
        return;
      }
      socket.join('booking:' + bookingId);
    });

    socket.on('send_message', (payload) => {
      const now = Date.now();
      if (now - socket.data.lastMessageAt < 400) return; // simple spam throttle
      socket.data.lastMessageAt = now;

      const { bookingId, text } = payload || {};
      const trimmed = (text || '').toString().slice(0, 1000).trim();
      if (!bookingId || !trimmed) return;

      const booking = db.get('bookings').find({ id: bookingId }).value();
      if (!canAccessBooking(user, booking)) {
        socket.emit('chat_error', { error: 'You do not have access to this chat.' });
        return;
      }

      const isCustomer = booking.userId === user.id;
      const message = {
        id: nanoid(), bookingId, senderId: user.id, senderName: user.name,
        senderRole: isCustomer ? 'customer' : 'professional', text: trimmed, createdAt: Date.now()
      };
      db.get('messages').push(message).write();

      io.to('booking:' + bookingId).emit('new_message', message);

      // Notify the other party in case they aren't actively in the chat right now.
      let recipientUserId = null;
      if (isCustomer && booking.professionalId) {
        const pro = db.get('professionals').find({ id: booking.professionalId }).value();
        recipientUserId = pro ? pro.userId : null;
      } else if (!isCustomer) {
        recipientUserId = booking.userId;
      }
      if (recipientUserId) {
        notify(recipientUserId, 'chat_message', 'New message', `${user.name}: ${trimmed.slice(0, 80)}`, isCustomer ? '/#/pro-dashboard' : '/#/dashboard');
      }
    });
  });

  return io;
}

module.exports = { attachChat };
