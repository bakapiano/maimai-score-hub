import 'vfonts/Lato.css'

import { createRouter, createWebHashHistory } from 'vue-router'

import App from './App.vue'
import Bot from './pages/BotPage.vue'
import Error from './pages/ErrorPage.vue'
import Home from './pages/HomePage.vue'
import Result from './pages/ResultPage.vue'
import Sbga from './pages/SbgaPage.vue'
import Score from './pages/ScorePage.vue'
import { createApp } from 'vue'

const routes = [
  { path: '/', component: Home, name: 'home' },
  { path: '/trace/:uuid/', component: Result, name: 'trace' },
  { path: '/score/', component: Score, name: 'score' },
  { path: '/bot/', component: Bot, name: 'bot' },
  { path: '/error/', component: Error, name: 'error' },
  { path: '/sbga/', component: Sbga, name: 'sbga' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

createApp(App).use(router).mount('#app')
