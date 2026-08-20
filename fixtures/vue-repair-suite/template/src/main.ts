import { createApp, defineComponent, h, ref } from "vue";
import App from "./App.vue";

const Root = {
  setup() {
    const guard = ref("ready");
    return () => h("div", [
      h(App),
      h("div", [
        h("button", { "data-testid": "regression-guard", onClick: () => { guard.value = "works"; } }, "Regression guard"),
        h("span", { "data-testid": "regression-guard-status" }, guard.value)
      ])
    ]);
  },
};

createApp(Root).mount("#app");
