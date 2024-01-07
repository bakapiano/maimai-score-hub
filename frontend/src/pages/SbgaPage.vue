<template>
  <n-spin :show="loading">
    <n-space vertical>
      <n-card class="card" title="获取uid">
        <n-form ref="formRef1" class="form" :rules="rules1" :model="formValue1">
          <n-p>
            在舞萌 DX 公众号中获取二维码后长按扫描二维码图片，粘贴扫描出来的字符串内容到下方输入框中，点击解析即可获取 uid
          </n-p>
          <n-form-item path="qrcode" label="二维码">
            <n-input v-model:value="formValue1.qrcode" placeholder="qrcode" />
          </n-form-item>
          <n-p v-if="formValue2?.uid !== undefined && formValue2?.uid !== '' && formValue2?.uid != -1">
            uid: {{ formValue2?.uid }}
          </n-p>
        </n-form>
        <template #action>
          <n-space justify="space-between">
            <n-space>
              <n-button type="info" @click="postQrcode"> 解析 </n-button>
            </n-space>
          </n-space>
        </template>
      </n-card>
      <n-card class="card" title="解小黑屋">
        <n-form ref="formRef2" class="form" :rules="rules2" :model="formValue2">
          <n-form-item path="uid" label="uid">
            <n-input v-model:value="formValue2.uid" placeholder="uid" />
          </n-form-item>
        </n-form>
        <template #action>
          <n-space justify="space-between">
            <n-space>
              <n-button type="info" @click="postUid"> Go </n-button>
            </n-space>
          </n-space>
        </template>
      </n-card>
    </n-space>
  </n-spin>
</template>
  
<script setup>
import { ref } from 'vue'
import { logout, qrcode } from '../api/sbga.js'
import { useMessage } from 'naive-ui'

const message = useMessage()
const loading = ref(false)

const formValue1 = ref({
  qrcode: '',
})

const formValue2 = ref({
  uid: '',
})

const rules1 = ref({
  qrcode: {
    required: true,
    message: '请输入二维码扫描后的字符串内容',
  },
})

const rules2 = ref({
  uid: {
    required: true,
    message: '请输入 uid',
  },
})

const formRef1 = ref(null)
const formRef2 = ref(null)

const postQrcode = async () => {
  loading.value = true
  try {
    const result = await qrcode(formValue1.value.qrcode)
    const uid = result?.data?.userID;
    if (uid === -1 || uid === undefined || uid === null) {
      message.error('解析失败，请尝重新获取二维码并重试！')
      formValue2.value.uid = ""
      return
    }

    formValue2.value.uid = String(uid)
    message.success(`解析成功`)
    return
  }
  catch (err) {
    message.error(err.response.data ? err.response.data : err.message)
    formValue2.value.uid = ""
  }
  finally {
    loading.value = false
  }
}

const postUid = async () => {
  loading.value = true
  try {
    const result = await logout(formValue2.value.uid)
    if (result?.data?.returnCode == 1) {
      message.success(`解除成功`)
    }
    else {
      message.error(`解除小黑屋，请重试！`)
    }
  }
  catch (err) {
    message.error(err.response.data ? err.response.data : err.message)
  }
  finally {
    loading.value = false
  }
}

</script>

<style scoped></style>
  