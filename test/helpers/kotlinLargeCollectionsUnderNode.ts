import { executeKotlinProgram } from '../../src/kotlin/execute';

const programs = [
  `fun main() {
    val values = IntArray(200000)
    println(values.size)
  }`,
  `fun main() {
    val values = IntArray(150000).toMutableList()
    values[0] = 1
    values.reverse()
    println(values.last())
  }`,
  `fun main() {
    val queue = ArrayDeque<Int>()
    repeat(30000) { queue.addLast(it) }
    var sum = 0L
    while (queue.isNotEmpty()) sum += queue.removeFirst()
    println(sum)
  }`,
];

console.log(JSON.stringify(programs.map((program) => executeKotlinProgram(program))));
