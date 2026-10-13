# JSON Reading

在 VS Code 中为表格型 JSON / JSONC 数据显示字段名。外层数组的第一个元素为字段名数组，后续每个数组为一条记录，字段按位置对应。

```json
[
  ["ID", "Characters", "Attribute", "Name"],
  [
    1,
    "19010004,19010014",
    [
      "AttackProp:0.10",
      "HpProp:0.10"
    ],
    "示例"
  ]
]
```

光标位于 `1` 所在行时，行尾会出现灰底的 `ID`；位于 `AttackProp:0.10` 或 `HpProp:0.10` 所在行时，会显示 `Attribute`。提示只是编辑器装饰，不会写入文件或影响复制内容。

## 显示模式

默认仅在光标所在行显示；选中多行或使用多个光标时，显示所有被选中的数据行。

- 点击右下角状态栏的 **字段名：选中行 / 全部行** 切换。
- 或执行命令 **JSON Reading: 切换字段名提示（全部行 / 选中行）**。
- 或在设置中搜索 `json-reading.fieldHints.displayMode`，选择 `selected`（仅选中行）或 `all`（全部行）。

```json
"json-reading.fieldHints.displayMode": "all"
```

设置会保存，重新打开文件仍然生效。默认保存到用户设置；若当前工作区或文件夹已有该设置，切换会更新对应作用域。

## 支持范围

- 支持 JSON 和 JSONC，JSONC 允许注释及尾随逗号。
- 字段名必须是首行数组中的字符串；普通 JSON 对象不显示提示。
- 嵌套数组、对象的内部行及括号行显示所属字段名。
- 一行包含多个字段时，按顺序使用 `·` 分隔字段名。
- 记录字段不足时显示已存在字段；超出表头的值不猜测字段名。
- 编辑过程中若 JSON 暂时无效，会清除提示；语法恢复后自动显示。
- 全部行模式随滚动显示当前可见的数据行，解析结果会缓存，编辑更新有 150ms 防抖。

## 开发与验证

```sh
npm install
npm run compile
npm run lint
npm run test:unit
npm test
```

按 F5 启动扩展开发窗口，打开上述格式的 JSON 文件即可体验。`npm test` 运行 VS Code 扩展宿主集成测试，首次运行需要下载匹配版本的 VS Code。
