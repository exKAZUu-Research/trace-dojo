import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { Box, Heading, Image, List, ListItem, Text, VStack } from '@/infrastructures/useClient/chakra';

const CoursesPage: MyAuthorizedNextPageOrLayout = () => {
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">トレース道場の使い方</Heading>
      <Box>
        <Text fontWeight="bold">■トレース道場の概要</Text>
        <Text>
          トレース道場では、タートルグラフィックスを使ったプログラムのトレース問題に挑戦します。問題には「
          <Text as="span" fontWeight="bold">
            一括実行モード
          </Text>
          」と「
          <Text as="span" fontWeight="bold">
            ステップ実行モード
          </Text>
          」の2種類があり、すべての問題は一括実行モードから始まり、一括実行モードはステップ実行モードよりも難易度が高めです。
          一括実行モードで3回間違えると、自動的に難易度の低いステップ実行モードへ切り替わります。
          どちらのモードでも、解答者はタートル（亀）を操作してプログラム実行後の盤面を再現し、変数の値を入力する必要があります。
          一括実行モードで正解するか、もしくはステップ実行モードのすべてのステップで正解すると、その問題は完了として記録されます。
          完了状態の詳細は、ページ下部の「完了のチェックマークがつくまで問題を解く」を参照してください。
        </Text>
        <Image alt="Usage Overview" my={4} src="/images/usage_01.png" />

        <Text fontWeight="bold" mt={16}>
          ■一括実行モードの解き方
        </Text>
        <Text>
          まず、出題されたプログラムを読んでタートルの初期位置を考えます。次に、以下の手順（下図参照）で盤面にタートルを配置します。
        </Text>
        <List my={2}>
          <ListItem>① 盤面内でタートルの初期位置となるマスをクリックします。</ListItem>
          <ListItem>② 「タートルを配置」ボタンをクリックしてタートルを置きます。</ListItem>
        </List>
        <Image alt="Initial Setup" my={4} src="/images/usage_02.png" />

        <Text mt={16}>
          ③タートルの初期位置が決まったら、プログラムを読み進めながら、「前に進む」「後に戻る」「↰（左回転）」「↱（右回転）」などの操作ボタンを使ってタートルを動かし、軌跡を描きます。
        </Text>
        <Image alt="Turtle Movement" my={4} src="/images/usage_03.png" />

        <Text mt={16}>
          ④盤面の下に「変数/式」「値」と書かれたフォームが表示されている場合は、プログラム実行後の最終的な変数の値を入力してください。
        </Text>
        <Image alt="Variable Input" my={4} src="/images/usage_04.png" />

        <Text mt={16}>誤った操作をした場合は、以下の方法で修正できます。</Text>
        <List my={2}>
          <ListItem>・誤った軌跡を描いた場合は、該当するマスを右クリックして白色に戻します。</ListItem>
          <ListItem>
            ・余分なタートルを配置した場合は、タートルを選択して「タートルを削除」ボタンを押して削除します。
          </ListItem>
          <ListItem>・最初からやり直したい場合は、「盤面をリセット」ボタンを押して盤面を初期状態に戻します。</ListItem>
        </List>

        <Text mt={16}>
          ⑤プログラム終了後の状態まで軌跡を描き終えたら、下図のように「提出」ボタンをクリックして解答を確認しましょう。
        </Text>
        <Image alt="How to Submit" my={4} src="/images/usage_05.png" />

        <Text mt={16}>
          正解の場合は、指示に従って問題一覧ページに戻り、次の問題に進みます。
          不正解の場合は、修正して再度挑戦してください。3回間違えるか、「諦めてステップ実行モードに移行する」ボタンをクリックすると、下図のようにステップ実行モードに移行します。
        </Text>
        <Image alt="Step Execution Mode" my={4} src="/images/usage_06.png" />

        <Text fontWeight="bold" mt={16}>
          ■ステップ実行モードの解き方
        </Text>
        <Text>
          一括実行モードで3回間違えると、より簡単なステップ実行モードに切り替わります。
          ステップ実行モードでは、プログラムを1ステップずつ（概ね1行ごとに）進め、変数の値の変化とタートルの軌跡を確認します。
          以下の手順（下図参照）で問題を解きます。
        </Text>
        <List my={2}>
          <ListItem>① 出題されたプログラム上の、赤い枠で囲まれた行を確認します。</ListItem>
          <ListItem>
            ②
            赤い枠で囲まれた行のプログラムを実行した後のタートルの位置や軌跡を盤面に描き、同じ行の変数の値をフォームに入力します。
          </ListItem>
          <ListItem>
            ③
            各ステップで変数の値を入力したり、タートルの位置や軌跡を描いたりしたら、その都度「提出」ボタンを押してください。正解するまで次のステップに進めないため、修正と提出を繰り返します。
          </ListItem>
        </List>
        <Text fontWeight="bold">
          なお、タートルや変数の動きがない行が選ばれることもあります。その場合は、盤面や値を変更せずに「提出」ボタンを押してください。
        </Text>
        <Image alt="How to Submit" my={4} src="/images/usage_07.png" />

        <Text mt={16}>
          ステップ実行モードでは、ステップごとに変数の値とタートルの動きを遡って確認できます。
          画面下部には直前の盤面と変数の一覧が表示され、「1ステップ前を表示」「1ステップ後を表示」ボタンを押すと、さらに前後の状態を確認できます。
        </Text>
        <Image alt="How to See Trace" my={4} src="/images/usage_08.png" />

        <Text>
          プログラムが終了するまで、ステップ実行モードの問題は続きます。最後まで解き終えたら問題一覧ページに戻り、次の問題に進みましょう。
        </Text>

        <Text fontWeight="bold" mt={16}>
          ■完了のチェックマークがつくまで問題を解く
        </Text>
        <List my={2}>
          <ListItem>
            ①
            問題に正解すると、問題一覧ページの各問題の先頭に完了のチェックマークが表示され、初回の完了日時も併せて表示されます。これらが表示されるまで問題を解き進めてください。
          </ListItem>
          <ListItem>② 「未完了」と表示されている問題は0点扱いです。</ListItem>
        </List>
        <Image alt="How to Check Completion" my={4} src="/images/usage_09.png" />
      </Box>
    </VStack>
  );
};

export default withAuthorizationOnServer(CoursesPage);
