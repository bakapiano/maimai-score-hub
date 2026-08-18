import {
  DXNET_PRIORITY,
  getDxnetDeliveryJobId,
  getDxnetPinnedQueueName,
  getDxnetRouteDefinition,
  getDxnetSharedQueueName,
  parseDxnetDeliveryJobId,
  toDxnetBullmqPriority,
} from '@maimai-score-hub/shared';

describe('DXNet routing policy', () => {
  it.each([
    ['user_interaction', 'send_friend_request', 'interactive', 3, 'pinned'],
    ['user_interaction', 'accept_friend_request', 'interactive', 3, 'pinned'],
    ['qr_login', 'get_full_friend_list', 'interactive', 4, 'claim'],
    ['cabinet_binding', 'get_full_friend_list', 'interactive', 4, 'claim'],
    ['user_sync', 'update_score', 'user_sync', 2, 'claim'],
    ['auto_update', 'update_score', 'background', 1, 'claim'],
    ['maintenance', 'get_full_friend_list', 'background', 0, 'pinned'],
  ] as const)(
    'maps %s/%s to %s priority=%s assignment=%s',
    (source, jobType, lane, priority, assignment) => {
      expect(getDxnetRouteDefinition(source, jobType)).toMatchObject({
        lane,
        priority,
        defaultAssignmentMode: assignment,
      });
    },
  );

  it('maps all business priorities to explicit non-zero BullMQ priorities', () => {
    expect(
      [
        DXNET_PRIORITY.maintenance,
        DXNET_PRIORITY.background,
        DXNET_PRIORITY.userSync,
        DXNET_PRIORITY.interactive,
        DXNET_PRIORITY.immediate,
      ].map(toDxnetBullmqPriority),
    ).toEqual([5, 4, 3, 2, 1]);
  });

  it('uses stable lane names and epoch delivery IDs', () => {
    expect(getDxnetSharedQueueName('user_sync')).toBe(
      'dxnet-shared-user-sync-jobs',
    );
    expect(getDxnetPinnedQueueName('123', 'background')).toBe(
      'dxnet-worker-123-background-jobs',
    );
    const deliveryId = getDxnetDeliveryJobId('mongo-id-with-dash', 7);
    expect(parseDxnetDeliveryJobId(deliveryId)).toEqual({
      jobId: 'mongo-id-with-dash',
      deliveryEpoch: 7,
    });
  });
});
