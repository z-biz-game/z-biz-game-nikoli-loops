// 墙钟测量的工具。
//
// 为什么单次墙钟不能直接当闸：一次测量的结果里混着两件事 ——
//   ① 生成器本身有多慢；② 测的那一瞬机器有多忙。
// 第二件事跟生成器无关，却会让「出题在手机上不卡」这道闸**随机变红**。
//
// 实测（本机满载时）：7×7 十道题测出 831ms，预算 800ms ⇒ 红；
// 同一批种子在空载时只要几百毫秒 ⇒ 绿。同一份代码，同一条断言，两次结论相反。
// 这种闸一旦进了 CI，就是**随机的红**：跑一次绿一次，不能当证据用。
//
// 组织里的既有惯例（不是自创）：
//   · herugolf/tools/counter-test.mjs —— 墙钟用 med / p95 记，并明写「只当上界看」；
//   · euclid/tools/playtest.mjs —— 明写「the honest measure is the best of the…」。
// 这里取**几轮里最快的一轮**：慢的生成器几轮都慢 ⇒ 闸照样红；
// 只有机器忙才会飘 ⇒ 闸量的是生成器自己的成本，不是机器当时的忙闲。
//
// 顺带用 hrtime.bigint() 而不是 Date.now()：后者是毫秒级整数，
// 预算只有几百毫秒时，量化误差占的比重太大（300ms 的预算里 ±1ms 就够让边界用例飘）。
export function bestOfMs(fn, rounds = 3) {
  let best = Infinity;
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}
