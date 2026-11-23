import { UNSIGNED_NUMBER_KINDS } from '../operators';

export function unsignedRanges(): string {
  return [
    ...(['UInt', 'ULong'] as const).map(unsignedProgression),
    ...(['UByte', 'UShort'] as const).flatMap((type) => unsignedRangeOperators(type, 'UInt')),
    ...(['UInt', 'ULong'] as const).flatMap((type) => unsignedRangeOperators(type, type)),
  ].join('\n');
}

function unsignedProgression(type: 'UInt' | 'ULong'): string {
  const signed = type === 'UInt' ? 'Int' : 'Long';
  const zero = type === 'UInt' ? '0' : '0L';
  const oneUnsigned = type === 'UInt' ? '1u' : '1uL';
  const zeroUnsigned = type === 'UInt' ? '0u' : '0uL';
  const progression = `${type}Progression`;
  const range = `${type}Range`;
  const encode = `orderKey${type}`;
  const decode = `fromOrder${type}`;
  const membership = UNSIGNED_NUMBER_KINDS.filter((other) => other !== type).map((other) => {
    const fits = type === 'UInt' && other === 'ULong' ? 'value <= UInt.MAX_VALUE && ' : '';
    return `operator fun ${range}.contains(value: ${other}): Boolean = ${fits}contains(value.to${type}())`;
  });
  return `
private fun ${type}.${encode}(): ${signed} = to${signed}() xor ${signed}.MIN_VALUE
private fun ${signed}.${decode}(): ${type} = (this xor ${signed}.MIN_VALUE).to${type}()

open class ${progression} internal constructor(private val ordered: ${signed}Progression) : Iterable<${type}> {
    val first: ${type} get() = ordered.first.${decode}()
    val last: ${type} get() = ordered.last.${decode}()
    val step: ${signed} get() = ordered.step
    override fun iterator(): Iterator<${type}> = ${progression}Iterator(ordered.iterator())
    open fun isEmpty(): Boolean = ordered.isEmpty()
    override fun equals(other: Any?): Boolean =
        other is ${progression} && (isEmpty() && other.isEmpty() || first == other.first && last == other.last && step == other.step)
    override fun hashCode(): Int = if (isEmpty()) -1 else 31 * (31 * first.hashCode() + last.hashCode()) + step.hashCode()
    override fun toString(): String = if (step > ${zero}) "$first..$last step $step" else "$first downTo $last step \${-step}"
    companion object {
        fun fromClosedRange(rangeStart: ${type}, rangeEnd: ${type}, step: ${signed}): ${progression} =
            ${progression}(${signed}Progression.fromClosedRange(rangeStart.${encode}(), rangeEnd.${encode}(), step))
    }
}

private class ${progression}Iterator(private val ordered: Iterator<${signed}>) : Iterator<${type}> {
    override fun hasNext(): Boolean = ordered.hasNext()
    override fun next(): ${type} = ordered.next().${decode}()
}

class ${range}(start: ${type}, endInclusive: ${type}) :
    ${progression}(${signed}Range(start.${encode}(), endInclusive.${encode}())), ClosedRange<${type}>, OpenEndRange<${type}> {
    override val start: ${type} get() = first
    override val endInclusive: ${type} get() = last
    override val endExclusive: ${type} get() {
        if (last == ${type}.MAX_VALUE) throw IllegalStateException("Cannot return the exclusive upper bound of a range that includes MAX_VALUE.")
        return last + ${oneUnsigned}
    }
    override fun isEmpty(): Boolean = first > last
    override fun contains(value: ${type}): Boolean = first <= value && value <= last
    override fun equals(other: Any?): Boolean =
        other is ${range} && (isEmpty() && other.isEmpty() || first == other.first && last == other.last)
    override fun hashCode(): Int = if (isEmpty()) -1 else 31 * first.hashCode() + last.hashCode()
    override fun toString(): String = "$first..$last"
    companion object {
        val EMPTY: ${range} = ${range}(${oneUnsigned}, ${zeroUnsigned})
    }
}

infix fun ${progression}.step(step: ${signed}): ${progression} {
    checkStepIsPositive(step > ${zero}, step)
    return ${progression}.fromClosedRange(first, last, if (this.step > ${zero}) step else -step)
}

fun ${progression}.reversed(): ${progression} = ${progression}.fromClosedRange(last, first, -step)
fun ${progression}.first(): ${type} = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else first
fun ${progression}.last(): ${type} = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else last
fun ${progression}.firstOrNull(): ${type}? = if (isEmpty()) null else first
fun ${progression}.lastOrNull(): ${type}? = if (isEmpty()) null else last

${membership.join('\n')}
`;
}

function unsignedRangeOperators(receiver: string, type: 'UInt' | 'ULong'): string[] {
  const left = receiver === type ? 'this' : `to${type}()`;
  const right = receiver === type ? 'to' : `to.to${type}()`;
  const one = type === 'UInt' ? '1u' : '1uL';
  const zero = type === 'UInt' ? '0u' : '0uL';
  const stride = type === 'UInt' ? '-1' : '-1L';
  return [
    `operator fun ${receiver}.rangeTo(to: ${receiver}): ${type}Range = ${type}Range(${left}, ${right})`,
    `operator fun ${receiver}.rangeUntil(to: ${receiver}): ${type}Range = until(to)`,
    `infix fun ${receiver}.downTo(to: ${receiver}): ${type}Progression = ${type}Progression.fromClosedRange(${left}, ${right}, ${stride})`,
    `infix fun ${receiver}.until(to: ${receiver}): ${type}Range =
        if (${right} == ${zero}) ${type}Range.EMPTY else ${type}Range(${left}, ${right} - ${one})`,
  ];
}
