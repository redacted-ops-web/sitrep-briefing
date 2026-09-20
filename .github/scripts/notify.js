const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const briefing = JSON.parse(fs.readFileSync('briefing/latest.json', 'utf8'));

const message = {
  topic: 'sitrep-daily',
  notification: {
    title: 'SITREP: ' + (briefing.headline || 'Daily briefing ready'),
    body: "Tap to hear today's conflict briefing.",
  },
  data: {
    date: briefing.date || '',
    headline: briefing.headline || '',
  },
};

admin.messaging().send(message)
  .then((response) => {
    console.log('Notification sent:', response);
  })
  .catch((error) => {
    console.error('Error sending notification:', error);
    process.exit(1);
  });
