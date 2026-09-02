// Import Firebase Compat scripts for the Service Worker
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js');

const firebaseConfig = {
  projectId: "sg-fun",
  databaseURL: "https://sg-fun-default-rtdb.firebaseio.com",
  messagingSenderId: "70359168339",
  appId: "1:70359168339:web:94d5ecf8b08ffe880c9da6"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title || 'CommScope Attendance';
  const notificationOptions = {
    body: payload.notification.body || 'New updates are available.',
    icon: 'https://ugc.production.linktr.ee/3185d4c0-2ed6-4e02-b0e3-d464551e7f43_canva-design.png?io=true&size=avatar-v3_0'
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const targetUrl = 'https://imsbg.github.io/commscope-contract-attendance/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url === targetUrl && 'focus' in client) { return client.focus(); }
      }
      if (clients.openWindow) { return clients.openWindow(targetUrl); }
    })
  );
});
