// Messages of the notifications feature. `en` must have exactly the same keys as `ar`.
const ar = {
  title: 'التنبيهات',
  subtitle: 'غير المقروءة: {{count}}',
  bell: 'التنبيهات',
  bellUnread: 'التنبيهات — غير المقروءة: {{count}}',
  unread: 'غير مقروء',
  unreadTab: 'غير المقروءة',
  markRead: 'تعليم كمقروء',
  markAllRead: 'تعليم الكل كمقروء',
  allMarked: 'تم تعليم كل التنبيهات كمقروءة',
  viewAll: 'عرض كل التنبيهات',
  empty: 'لا توجد تنبيهات',
  noUnread: 'لا توجد تنبيهات غير مقروءة',
  emptyHint: 'ستصلك هنا تنبيهات إسناد العملاء والفرص ومواعيد المتابعة وطلبات الموافقة.',
};

const en: typeof ar = {
  title: 'Notifications',
  subtitle: 'Unread: {{count}}',
  bell: 'Notifications',
  bellUnread: 'Notifications — unread: {{count}}',
  unread: 'Unread',
  unreadTab: 'Unread',
  markRead: 'Mark as read',
  markAllRead: 'Mark all as read',
  allMarked: 'All notifications marked as read',
  viewAll: 'View all notifications',
  empty: 'No notifications',
  noUnread: 'No unread notifications',
  emptyHint: 'Customer and lead assignments, follow-up reminders and approval requests appear here.',
};

export default { ar, en };
