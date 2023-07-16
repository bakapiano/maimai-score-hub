import { Low, Memory } from "lowdb";

import { JSONFile } from "lowdb/node";

var fileDB : any= new Low(new JSONFile("db.json"), null);
var memoDB : any = new Low(new Memory(), null);

fileDB.read().then(() => {
  if (!fileDB.data.count) {
    fileDB.data.count = 0;
  }
  if (!fileDB.data.friendCodeList) {
    fileDB.data.friendCodeList = {};
  }
  fileDB.write();
});

memoDB.read().then(() => {
  memoDB.data = { time: {} };
});

async function setValue(key : string, value : any) {
  memoDB.data.time[key] = new Date().getTime();
  memoDB.data[key] = value;
}

async function getValue(key : string) {
  return memoDB.data[key];
}

async function appendValue(key : string, value : any, defaultValue : any) {
  let current = memoDB.data[key];
  if (current === undefined) {
    current = defaultValue;
  }
  memoDB.data.time[key] = new Date().getTime();
  memoDB.data[key] = current + value;
}

async function delValue(key : string) {
  if (memoDB.data[key] !== undefined) {
    delete memoDB.data[key];
  }
  if (memoDB.data.time[key] !== undefined) {
    delete memoDB.data.time[key];
  }
}

async function clearExpireData() {
  Object.keys(memoDB.data.time).forEach(async (key) => {
    const current = new Date().getTime();
    const delta = current - memoDB.data.time[key];
    if (delta >= 1000 * 60 * 30 * 1) {
      await delValue(key);
    }
  });
}

function checkFriendCodeCache(friendCode: string) {
  if (fileDB.data.friendCodeList === undefined) return false;
  return fileDB.data.friendCodeList[friendCode] !== undefined;
}

function addFriendCodeCache(friendCode: string) {
  if (fileDB.data.friendCodeList === undefined) return;
  fileDB.data.friendCodeList[friendCode] = "1";
}

function increaseCount() {
  if (fileDB.data.count === undefined) return;
  fileDB.data.count += 1;
}

function getCount() {
  return fileDB.data?.count || 0;
}

async function saveFileDB() {
  await fileDB.write();
}
  
export interface QueueData {
  username: string;
  password: string;
  traceUUID: string;
  friendCode: string;
  
  createTime: number; // 进入队列的时间
  
  requestSentTime?: number; // 尝试发送好友请求的时间
  requestConfirmedTime? : number; // 确认好友请求发送成功的时间

  acceptSentTime?: number; // 尝试接受好友请求的时间
}

function getQueue() : QueueData[] {
  if (memoDB.data.quque === undefined) {
    memoDB.data.quque = [];
  }
  return memoDB.data.quque;
}

function appendQueue(data: QueueData) {
  if (memoDB.data.quque === undefined) {
    memoDB.data.quque = [];
  }
  memoDB.data.quque.push(data);
}

function removeFromQueue(data: QueueData) {
  if (memoDB.data.quque === undefined) {
    memoDB.data.quque = [];
  }
  const {traceUUID} = data
  memoDB.data.quque = memoDB.data.quque.filter((item: any) => item.traceUUID !== traceUUID);
}

function removeFromQueueByFriendCode(friendCode: string) {
  if (memoDB.data.quque === undefined) {
    memoDB.data.quque = [];
  }
  memoDB.data.quque = memoDB.data.quque.filter((item: any) => item.friendCode !== friendCode);
}

export {
  setValue,
  getValue,
  delValue,
  increaseCount,
  getCount,
  clearExpireData,
  saveFileDB,
  appendValue,
  appendQueue,
  getQueue,
  removeFromQueue,
  checkFriendCodeCache,
  addFriendCodeCache,
  removeFromQueueByFriendCode,
};
