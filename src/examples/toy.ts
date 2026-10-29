import type { Benchmark, Task } from "../types.js";
import { LocalTestScorer, type LocalTestInput } from "../local-test-scorer.js";

const testHarness = (body: string) =>
  `import assert from "node:assert/strict";\nimport * as m from "./solution.mjs";\n${body}\nconsole.log("ok");\n`;

const def = (id: string, prompt: string, stub: string, tests: string): Task<LocalTestInput> => ({
  id,
  prompt: `${prompt}\nEdit solution.mjs and export the function.`,
  input: {
    starterFiles: { "solution.mjs": stub },
    testFiles: { "test.mjs": testHarness(tests) },
    command: [process.execPath, "test.mjs"],
  },
  tags: ["js", "toy"],
});

export const toyTasks: Task<LocalTestInput>[] = [
  def("toy/add", "Implement add(a, b) returning a + b.", "export function add(a, b) {}\n",
    `assert.equal(m.add(2, 3), 5);\nassert.equal(m.add(-1, 1), 0);`),
  def("toy/reverse", "Implement reverse(s) returning the string reversed.", "export function reverse(s) {}\n",
    `assert.equal(m.reverse("abc"), "cba");\nassert.equal(m.reverse(""), "");`),
  def("toy/fizzbuzz", "Implement fizzbuzz(n) returning an array of strings 1..n with Fizz/Buzz/FizzBuzz.",
    "export function fizzbuzz(n) {}\n",
    `assert.deepEqual(m.fizzbuzz(5), ["1","2","Fizz","4","Buzz"]);\nassert.equal(m.fizzbuzz(15)[14], "FizzBuzz");`),
  def("toy/is-palindrome", "Implement isPalindrome(s), ignoring case and non-alphanumerics.",
    "export function isPalindrome(s) {}\n",
    `assert.equal(m.isPalindrome("A man, a plan, a canal: Panama"), true);\nassert.equal(m.isPalindrome("ab"), false);`),
  def("toy/sum-evens", "Implement sumEvens(xs) returning the sum of even numbers.", "export function sumEvens(xs) {}\n",
    `assert.equal(m.sumEvens([1,2,3,4]), 6);\nassert.equal(m.sumEvens([]), 0);`),
];

/** Reference solutions, used in tests to prove the tasks are solvable. */
export const toyReferenceSolutions: Record<string, string> = {
  "toy/add": "export const add = (a, b) => a + b;\n",
  "toy/reverse": "export const reverse = (s) => [...s].reverse().join('');\n",
  "toy/fizzbuzz": "export const fizzbuzz = (n) => Array.from({length:n},(_,i)=>{i++;return i%15===0?'FizzBuzz':i%3===0?'Fizz':i%5===0?'Buzz':String(i)});\n",
  "toy/is-palindrome": "export const isPalindrome = (s) => { const t = s.toLowerCase().replace(/[^a-z0-9]/g,''); return t === [...t].reverse().join(''); };\n",
  "toy/sum-evens": "export const sumEvens = (xs) => xs.filter(x => x % 2 === 0).reduce((a,b)=>a+b,0);\n",
};

export const toyBenchmark: Benchmark<LocalTestInput> = {
  name: "toy-js",
  version: "1",
  description: "Five tiny JS functions scored by local node:assert tests.",
  loadTasks: async () => toyTasks,
  scorer: new LocalTestScorer(),
};
